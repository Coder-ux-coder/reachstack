import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, History, RotateCcw } from "lucide-react";
import { isTaskStep, type SequenceStep } from "@reachstack/shared";
import { errorMessage, get, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { dateTime, plural } from "@/lib/format";
import { EmailFrame } from "@/components/EmailFrame";
import { Badge, Button, Callout, Dialog, EmptyState, SkeletonRows } from "@/components/ui";
import { TaskIcon, defaultTaskTitle, taskLabel } from "./task-steps";

interface Version {
  id: string;
  created_at: string;
  created_by_name: string | null;
  source: "edit" | "create" | "restore" | "agent" | "earlier";
  restored_from_at: string | null;
  /** In the list: the newest version, which the sequence still holds. In a preview: the same steps as the sequence now. */
  current: boolean;
  summary: string;
  first_subject: string | null;
}

type VersionWithSteps = Version & { sequences: Array<{ steps: SequenceStep[] }> };

const letter = (i: number) => String.fromCharCode(65 + i);

/** Who saved a version, in a few words. */
function savedBy(v: Version): string {
  const who = v.created_by_name;
  if (v.source === "earlier") return "From before versions were kept";
  if (v.source === "create") return who ? `Created by ${who}` : "Created";
  if (v.source === "restore") return `${who ? `${who} restored` : "Restored"} ${v.restored_from_at ? `the version from ${dateTime(v.restored_from_at)}` : "an older version"}`;
  return who ? `Saved by ${who}` : "Saved";
}

/** When a step goes out, as the editor describes it. */
function stepTiming(steps: SequenceStep[], i: number, subsequence: boolean): string {
  const unit = (s: SequenceStep, n: number, which: "delay" | "pre") => {
    const u = (which === "pre" ? s.pre_delay_unit : s.delay_unit) ?? "days";
    return n === 1 ? u.replace(/s$/, "") : u;
  };
  if (i === 0) {
    const first = steps[0]!;
    if (subsequence && first.pre_delay) return `${first.pre_delay} ${unit(first, first.pre_delay, "pre")} after the lead joins`;
    return isTaskStep(first) ? "When the lead joins" : "First email";
  }
  const prev = steps[i - 1]!;
  return `${prev.delay} ${unit(prev, prev.delay, "delay")} after step ${i}${isTaskStep(prev) ? " is done" : ""}`;
}

function Preview({ version, subsequence }: { version: VersionWithSteps; subsequence: boolean }) {
  const steps = version.sequences[0]?.steps ?? [];
  return (
    <div className="space-y-3">
      {steps.map((s, i) => (
        <div key={i} className="rounded-lg border border-line">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line bg-panel-2/50 px-3 py-2">
            <span className="flex items-center gap-1.5 text-[13px] font-semibold">
              {isTaskStep(s) && <TaskIcon kind={s.task} size={13} className="text-muted" />}
              Step {i + 1}
              {isTaskStep(s) && <span className="font-normal text-muted">· {taskLabel(s.task)}</span>}
            </span>
            <span className="text-xs text-muted">{stepTiming(steps, i, subsequence)}</span>
          </div>
          {isTaskStep(s) ? (
            <div className="space-y-1.5 px-3 py-2.5 text-[13px]">
              <p>
                <span className="text-muted">Title: </span>
                {s.variants[0]?.subject || <span className="text-faint">{defaultTaskTitle(s.task)}</span>}
              </p>
              {s.variants[0]?.body ? <p className="whitespace-pre-wrap">{s.variants[0].body}</p> : <p className="text-faint">No note</p>}
            </div>
          ) : (
          <div className="divide-y divide-line">
            {s.variants.map((v, j) => (
              <div key={j} className="space-y-1.5 px-3 py-2.5">
                {s.variants.length > 1 && (
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">
                    Variant {letter(j)}
                    {v.v_disabled ? " · disabled" : ""}
                  </p>
                )}
                <p className="text-[13px]">
                  <span className="text-muted">Subject: </span>
                  {v.subject || <span className="text-faint">{i === 0 ? (subsequence ? "The parent campaign's subject" : "Empty") : "Same thread as the previous email"}</span>}
                </p>
                {v.body ? <EmailFrame html={v.body} minHeight={40} /> : <p className="text-[13px] text-faint">Empty email</p>}
              </div>
            ))}
          </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Sequences tab → Versions: the saved versions of a campaign's or subsequence's sequence, newest first, with a read-only
 * preview and "Restore this version". Restoring saves those steps again, so the sequence it replaces stays in the list.
 */
export function VersionsDialog({
  open,
  onOpenChange,
  path,
  dirty,
  readOnly,
  subsequence = false,
  onRestored,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** The campaign or subsequence: "/api/app/campaigns/:id" or "/api/app/subsequences/:id". */
  path: string;
  /** The editor has unsaved changes, which a restore replaces. */
  dirty: boolean;
  readOnly?: boolean;
  subsequence?: boolean;
  /** Reloads the campaign or subsequence once a restore saved its new steps. */
  onRestored: () => Promise<unknown>;
}) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const list = useQuery({ queryKey: ["sequence-versions", path], queryFn: () => get<{ items: Version[] }>(`${path}/sequence-versions`), enabled: open, staleTime: 0 });
  const items = list.data?.items ?? [];
  const preview = useQuery({
    queryKey: ["sequence-versions", path, selected],
    queryFn: () => get<VersionWithSteps>(`${path}/sequence-versions/${selected}`),
    enabled: open && !!selected,
    staleTime: 0,
  });
  const v = preview.data;

  useEffect(() => {
    if (open) {
      setSelected(null);
      setAsking(false);
    }
  }, [open]);
  useEffect(() => setAsking(false), [selected]);

  const restore = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await post(`${path}/sequence-versions/${selected}/restore`);
      await onRestored();
      await qc.invalidateQueries({ queryKey: ["sequence-versions", path] });
      toast.success("Version restored");
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="xl" title="Versions" description="Every saved change to this sequence, newest first. The last 50 are kept.">
      {list.isLoading ? (
        <SkeletonRows rows={4} />
      ) : !items.length ? (
        <EmptyState className="py-10" icon={<History size={20} />} title="No versions yet" description="Each time the sequence is saved, the version is kept here." />
      ) : (
        <div className="grid gap-4 md:grid-cols-[16rem_minmax(0,1fr)]">
          <ul className={cn("space-y-1.5", selected && "hidden md:block")} aria-label="Versions">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setSelected(item.id)}
                  aria-current={item.id === selected || undefined}
                  className={cn("w-full rounded-lg border px-3 py-2 text-left transition-colors", item.id === selected ? "border-brand bg-brand-soft/40" : "border-line hover:border-line-strong hover:bg-panel-2")}
                >
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium">{dateTime(item.created_at)}</span>
                    {item.current && <Badge tone="ok">Current</Badge>}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted">{savedBy(item)}</span>
                  <span className="mt-0.5 block truncate text-xs text-faint">
                    {item.summary}
                    {item.first_subject ? ` · ${item.first_subject}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <div className={cn("min-w-0", !selected && "hidden md:block")}>
            {!selected ? (
              <p className="rounded-lg border border-dashed border-line px-4 py-10 text-center text-[13px] text-muted">Pick a version to see its emails.</p>
            ) : (
              <div className="space-y-3">
                <Button size="sm" variant="ghost" icon={<ArrowLeft size={14} />} className="md:hidden" onClick={() => setSelected(null)}>
                  All versions
                </Button>
                {preview.isLoading || !v ? (
                  <SkeletonRows rows={3} />
                ) : (
                  <>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[13px] font-semibold">{dateTime(v.created_at)}</p>
                        <p className="text-xs text-muted">
                          {savedBy(v)} · {plural(v.sequences[0]?.steps.length ?? 0, "step")}
                        </p>
                      </div>
                      {!readOnly && !v.current && !asking && (
                        <Button size="sm" variant="primary" icon={<RotateCcw size={14} />} onClick={() => setAsking(true)}>
                          Restore this version
                        </Button>
                      )}
                    </div>
                    {v.current && <Callout tone="ok">This is the sequence as it is now.</Callout>}
                    {asking && (
                      <Callout tone={dirty ? "warn" : "info"} title="Restore this version?">
                        {dirty ? "Its steps replace the sequence, and your unsaved changes are lost." : "Its steps replace the sequence."} The sequence as it is now stays in this list, so
                        you can switch back.
                        <div className="mt-2.5 flex flex-wrap gap-2">
                          <Button size="sm" variant="primary" loading={busy} onClick={restore}>
                            Restore
                          </Button>
                          <Button size="sm" onClick={() => setAsking(false)}>
                            Cancel
                          </Button>
                        </div>
                      </Callout>
                    )}
                    <Preview version={v} subsequence={subsequence} />
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** The "Versions" button next to the editor's preview button, with its dialog. */
export function VersionsButton(props: Omit<Parameters<typeof VersionsDialog>[0], "open" | "onOpenChange">) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" icon={<History size={14} />} onClick={() => setOpen(true)}>
        Versions
      </Button>
      <VersionsDialog open={open} onOpenChange={setOpen} {...props} />
    </>
  );
}
