// Copilot tasks: prompts Copilot answers on a schedule. Each run opens a new chat and sends a notification.
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { CalendarClock, MessageSquare, Pencil, Play, Plus, RotateCcw, Trash2 } from "lucide-react";
import { CAMPAIGN_TIMEZONES } from "@reachstack/shared";
import { Badge, Button, Callout, Card, Dialog, EmptyState, Field, Input, MenuItem, MenuSeparator, NativeSelect, RowMenu, Segmented, Skeleton, Spinner, Switch, Textarea, useConfirm } from "@/components/ui";
import { del, errorMessage, patch, post } from "@/lib/api";
import { ago, dateTime } from "@/lib/format";
import { usePageTitle } from "@/lib/hooks";
import { queryClient } from "@/lib/query";
import { useSession } from "@/lib/session";
import { TASKS_KEY, THREADS_KEY, useCopilotSettings, useTasks, type CopilotTask } from "./api";

type Frequency = CopilotTask["frequency"];
const FREQ_LABEL: Record<Frequency, string> = { daily: "Every day", weekly: "Every week", monthly: "Every month" };

function upsertTask(t: CopilotTask) {
  queryClient.setQueryData<{ items: CopilotTask[] }>(TASKS_KEY, (d) => {
    const items = d?.items ?? [];
    return { items: items.some((x) => x.id === t.id) ? items.map((x) => (x.id === t.id ? t : x)) : [t, ...items] };
  });
}

function TaskDialog({ task, open, onOpenChange }: { task: CopilotTask | null; open: boolean; onOpenChange: (v: boolean) => void }) {
  const me = useSession();
  const localTz = me.user.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [frequency, setFrequency] = useState<Frequency>("weekly");
  const [time, setTime] = useState("09:00");
  const [tz, setTz] = useState(localTz);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setTitle(task?.title ?? "");
    setPrompt(task?.prompt ?? "");
    setFrequency(task?.frequency ?? "weekly");
    setTime(task?.time_of_day ?? "09:00");
    setTz(task?.timezone ?? localTz);
  }, [open, task, localTz]);
  const zones = (CAMPAIGN_TIMEZONES as readonly string[]).includes(tz) ? [...CAMPAIGN_TIMEZONES] : [tz, ...CAMPAIGN_TIMEZONES];
  const valid = title.trim() && prompt.trim().length >= 3 && /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  const save = async () => {
    setBusy(true);
    try {
      const body = { title: title.trim(), prompt: prompt.trim(), frequency, time_of_day: time, timezone: tz };
      const t = task ? await patch<CopilotTask>(`/api/app/copilot/tasks/${task.id}`, body) : await post<CopilotTask>("/api/app/copilot/tasks", body);
      upsertTask(t);
      toast.success(task ? "Task updated" : `Task scheduled. First run ${dateTime(t.next_run_at)}.`);
      onOpenChange(false);
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
      title={task ? "Edit task" : "New task"}
      description="Copilot answers the prompt on this schedule, in a new chat each time."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={save}>
            {task ? "Save" : "Schedule task"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">{(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Weekly results" maxLength={120} autoFocus />}</Field>
        <Field label="Prompt" hint="Write it as you would in a chat.">
          {(id) => <Textarea id={id} rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Summarize last week's campaign results and tell me what to change." maxLength={4_000} />}
        </Field>
        <Field label="How often">
          {() => (
            <Segmented
              value={frequency}
              onChange={setFrequency}
              options={[
                { value: "daily", label: "Daily" },
                { value: "weekly", label: "Weekly" },
                { value: "monthly", label: "Monthly" },
              ]}
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-[9rem_1fr]">
          <Field label="Time">{(id) => <Input id={id} type="time" value={time} onChange={(e) => setTime(e.target.value)} />}</Field>
          <Field label="Timezone">{(id) => <NativeSelect id={id} value={tz} onChange={setTz} options={zones.map((z) => ({ value: z, label: z.replace(/_/g, " ") }))} />}</Field>
        </div>
        {frequency !== "daily" && <p className="text-xs text-muted">The first run is the next time the clock reaches this time; later runs follow {frequency === "weekly" ? "a week" : "a month"} apart.</p>}
      </div>
    </Dialog>
  );
}

function TaskCard({ task, onEdit }: { task: CopilotTask; onEdit: () => void }) {
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const act = async (f: () => Promise<CopilotTask | void>, done?: string) => {
    setBusy(true);
    try {
      const t = await f();
      if (t) upsertTask(t);
      if (done) toast.success(done);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!(await confirm({ title: `Delete “${task.title}”?`, description: "It stops running. Chats from earlier runs stay.", confirmLabel: "Delete", danger: true }))) return;
    await act(async () => {
      await del(`/api/app/copilot/tasks/${task.id}`);
      queryClient.setQueryData<{ items: CopilotTask[] }>(TASKS_KEY, (d) => d && { items: d.items.filter((x) => x.id !== task.id) });
    }, "Task deleted");
  };
  const failed = task.last_status === "failed";
  return (
    <Card className="flex items-start gap-3">
      <span className="pt-0.5">
        <Switch
          checked={task.status === "active"}
          disabled={busy}
          aria-label={task.status === "active" ? `Pause ${task.title}` : `Resume ${task.title}`}
          onChange={(v) => void act(() => patch<CopilotTask>(`/api/app/copilot/tasks/${task.id}`, { status: v ? "active" : "paused" }), v ? "Task resumed" : "Task paused")}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[14px] font-medium">{task.title}</p>
          {task.status === "paused" && <Badge>Paused</Badge>}
        </div>
        <p className="mt-0.5 text-xs text-muted">
          {FREQ_LABEL[task.frequency]} at {task.time_of_day ?? "09:00"} {task.timezone ? `(${task.timezone.replace(/_/g, " ")})` : ""}
          {task.next_run_at && <> · next run {dateTime(task.next_run_at)}</>}
        </p>
        <p className="mt-1.5 line-clamp-2 text-[13px] text-muted">{task.prompt}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {task.running ? (
            <span className="inline-flex items-center gap-1.5 text-brand-text">
              <Spinner size={12} /> Running now…
            </span>
          ) : task.last_run_at ? (
            <>
              <Badge tone={failed ? "bad" : task.last_status === "waiting" ? "warn" : "ok"}>{failed ? "Failed" : task.last_status === "waiting" ? "Needs your approval" : "Done"}</Badge>
              <span className="text-faint">
                Last run {ago(task.last_run_at)} · {task.run_count} {task.run_count === 1 ? "run" : "runs"}
              </span>
              {task.last_thread_id && (
                <Link to={`/app/copilot/${task.last_thread_id}`} className="-my-1 py-1 font-medium text-brand-text hover:underline">
                  Open result
                </Link>
              )}
            </>
          ) : (
            <span className="text-faint">Hasn't run yet</span>
          )}
        </div>
        {failed && task.last_error && !task.running && <p className="mt-1.5 line-clamp-2 text-xs text-bad">{task.last_error}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          size="sm"
          icon={failed ? <RotateCcw size={14} /> : <Play size={14} />}
          disabled={busy || task.running}
          aria-label={failed ? "Retry" : "Run now"}
          onClick={() => void act(() => post<CopilotTask>(`/api/app/copilot/tasks/${task.id}/run`), "Running the task. You'll get a notification when it's done.")}
        >
          <span className="hidden sm:inline">{failed ? "Retry" : "Run now"}</span>
        </Button>
        <RowMenu label={`Actions for ${task.title}`}>
          <MenuItem icon={<Pencil size={14} />} onSelect={onEdit}>
            Edit
          </MenuItem>
          {task.source_thread_id && (
            <MenuItem icon={<MessageSquare size={14} />} onSelect={() => navigate(`/app/copilot/${task.source_thread_id}`)}>
              Open the original chat
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem danger icon={<Trash2 size={14} />} onSelect={() => void remove()}>
            Delete
          </MenuItem>
        </RowMenu>
      </div>
    </Card>
  );
}

export function CopilotTasks() {
  usePageTitle("Copilot tasks");
  const tasks = useTasks();
  const settings = useCopilotSettings();
  const [editing, setEditing] = useState<CopilotTask | null>(null);
  const [open, setOpen] = useState(false);
  const items = tasks.data?.items ?? [];
  // A finished run opened a new chat: show it under Recents.
  const lastChats = items.map((t) => t.last_thread_id ?? "").join();
  useEffect(() => {
    if (lastChats) void queryClient.invalidateQueries({ queryKey: THREADS_KEY });
  }, [lastChats]);
  const edit = (t: CopilotTask | null) => {
    setEditing(t);
    setOpen(true);
  };
  const slack = settings.data?.settings.slack_integration_id ? settings.data.slack_connections.find((c) => c.id === settings.data!.settings.slack_integration_id) : null;
  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Tasks</h1>
            <p className="mt-1 text-[13px] text-muted">
              Prompts Copilot runs on a schedule. Each run opens a new chat and sends you a notification
              {slack ? ` and a Slack message (${slack.name})` : ""}.
            </p>
          </div>
          {items.length > 0 && (
            <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => edit(null)}>
              New task
            </Button>
          )}
        </div>
        {settings.data && !settings.data.ai_available && (
          <Callout tone="warn" className="mt-4">
            Tasks can't run until AI is set up: add an Anthropic API key in Settings → Integrations & API → AI.
          </Callout>
        )}
        <div className="mt-5 space-y-2">
          {tasks.isLoading && (
            <>
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </>
          )}
          {tasks.isError && <Callout tone="bad">{errorMessage(tasks.error)}</Callout>}
          {!tasks.isLoading && !items.length && !tasks.isError && (
            <EmptyState
              icon={<CalendarClock size={20} />}
              title="No tasks yet"
              description="Have Copilot report on your campaigns every Monday, check your accounts each morning, or anything else you'd ask it regularly. You can also turn on Recurring when you start a chat."
              action={
                <Button variant="primary" icon={<Plus size={14} />} onClick={() => edit(null)}>
                  New task
                </Button>
              }
            />
          )}
          {items.map((t) => (
            <TaskCard key={t.id} task={t} onEdit={() => edit(t)} />
          ))}
        </div>
      </div>
      <TaskDialog task={editing} open={open} onOpenChange={setOpen} />
    </div>
  );
}
