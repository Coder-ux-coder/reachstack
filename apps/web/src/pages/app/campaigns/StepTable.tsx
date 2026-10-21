import { TASK_STEPS, isTaskStep, type SequenceStep } from "@reachstack/shared";
import { num, pct, plural } from "@/lib/format";
import { TaskIcon } from "@/components/sequence/task-steps";
import { ScrollX } from "@/components/ui/scroll-x";

export interface StepRow {
  step: string | null;
  variant: string | null;
  sent: number;
  unique_opened: number;
  unique_replies: number;
  unique_clicks: number;
  bounced: number;
  opportunities?: number;
  meetings_booked?: number;
  won?: number;
  /** Task steps: tasks marked done, and skipped. */
  tasks_done?: number;
  tasks_skipped?: number;
}

const letter = (i: number) => String.fromCharCode(65 + i);

const COUNTS = ["sent", "unique_opened", "unique_replies", "unique_clicks", "bounced", "opportunities", "meetings_booked", "won", "tasks_done", "tasks_skipped"] as const;

/**
 * One row per step and variant, in step order. Figures with no variant (a reply from before replies were matched to
 * the email they answer) belong to a step's only variant; with more than one they stay apart as "variant unknown".
 */
function byStep(rows: StepRow[], steps: SequenceStep[]): StepRow[] {
  const out = new Map<string, StepRow>();
  for (const r of rows) {
    if (r.step === null) continue;
    const variant = r.variant === null && (steps[Number(r.step)]?.variants.length ?? 1) <= 1 ? "0" : r.variant;
    const key = `${r.step}:${variant}`;
    const cur = out.get(key);
    if (!cur) out.set(key, { ...r, variant });
    else for (const k of COUNTS) if (r[k] !== undefined) cur[k] = (cur[k] ?? 0) + r[k]!;
  }
  return [...out.values()].sort((a, b) => Number(a.step) - Number(b.step) || (a.variant === null ? 1 : b.variant === null ? -1 : Number(a.variant) - Number(b.variant)));
}

/** Emails sent and what came of them, per step and variant, in step order. */
export function StepTable({
  rows,
  steps,
  tracking,
  opportunities,
  loading,
  subsequence = false,
}: {
  rows: StepRow[];
  steps: SequenceStep[];
  tracking: boolean;
  opportunities: boolean;
  loading: boolean;
  subsequence?: boolean;
}) {
  const sorted = byStep(rows, steps);
  // Step, Sent, Replied, Clicked and Bounced, with Opened and Opportunities when shown.
  const columns = 5 + (tracking ? 1 : 0) + (opportunities ? 1 : 0);
  return (
    <ScrollX>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            <th className="px-4 py-2 font-medium">Step</th>
            <th className="px-4 py-2 text-right font-medium">Sent</th>
            {tracking && <th className="px-4 py-2 text-right font-medium">Opened</th>}
            <th className="px-4 py-2 text-right font-medium">Replied</th>
            <th className="px-4 py-2 text-right font-medium">Clicked</th>
            {opportunities && <th className="px-4 py-2 text-right font-medium">Opportunities</th>}
            <th className="px-4 py-2 text-right font-medium">Bounced</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const si = Number(r.step);
            const vi = r.variant === null ? null : Number(r.variant);
            const v = vi === null ? undefined : steps[si]?.variants[vi];
            // More than one variant in the sequence or in the figures (one may have been deleted since): rows say which.
            const multi = (steps[si]?.variants.length ?? 1) > 1 || sorted.some((o) => o.step === r.step && o.variant !== r.variant);
            const task = steps[si];
            if (isTaskStep(task)) {
              const kind = task!.task ?? "todo";
              return (
                <tr key={`${r.step}-${r.variant}`} className="border-b border-line last:border-0">
                  <td className="max-w-[22rem] px-4 py-2.5" title="A task you do by hand">
                    <p className="flex items-center gap-1.5 whitespace-nowrap font-medium">
                      <TaskIcon kind={kind} size={13} className="shrink-0 text-muted" />
                      Step {si + 1}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {TASK_STEPS[kind].label}
                      {v?.subject ? ` · ${v.subject}` : ""}
                    </p>
                  </td>
                  <td colSpan={columns - 1} className="whitespace-nowrap px-4 py-2.5 text-muted">
                    <span className="tabular-nums text-text">{plural(r.tasks_done ?? 0, "task")}</span> done
                    {!!r.tasks_skipped && <span className="tabular-nums"> · {num(r.tasks_skipped)} skipped</span>}
                  </td>
                </tr>
              );
            }
            return (
              <tr key={`${r.step}-${r.variant}`} className="border-b border-line last:border-0">
                <td className="max-w-[22rem] px-4 py-2.5">
                  <p className="font-medium">
                    Step {si + 1}
                    {multi && <span className="ml-1.5 rounded bg-panel-2 px-1.5 text-xs text-muted">{vi === null ? "Variant unknown" : `Variant ${letter(vi)}`}</span>}
                    {v?.v_disabled && <span className="ml-1.5 rounded bg-panel-2 px-1.5 text-xs text-faint">Off</span>}
                  </p>
                  <p className="truncate text-xs text-muted">{v ? v.subject || (si > 0 ? "Same thread as the previous email" : subsequence ? "The campaign's subject" : "No subject") : vi === null ? "Replies from before variants were matched" : steps[si] ? "Deleted variant" : "Deleted step"}</p>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">{num(r.sent)}</td>
                {tracking && (
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {num(r.unique_opened)} <span className="text-faint">{pct(r.unique_opened, r.sent)}</span>
                  </td>
                )}
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {num(r.unique_replies)} <span className="text-faint">{pct(r.unique_replies, r.sent)}</span>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {num(r.unique_clicks)} <span className="text-faint">{pct(r.unique_clicks, r.sent)}</span>
                </td>
                {opportunities && <td className="px-4 py-2.5 text-right tabular-nums">{num(r.opportunities ?? 0)}</td>}
                <td className="px-4 py-2.5 text-right tabular-nums">{num(r.bounced)}</td>
              </tr>
            );
          })}
          {!sorted.length && (
            <tr>
              <td colSpan={columns} className="px-4 py-10 text-center text-muted">
                {loading ? "Loading…" : "No emails sent in this period."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </ScrollX>
  );
}
