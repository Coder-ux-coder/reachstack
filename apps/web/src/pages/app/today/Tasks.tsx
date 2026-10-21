// Tasks the sequences ask for (task steps): a LinkedIn visit, invitation or message, a call, or anything else done by
// hand. Done or Skip moves the lead on to the next step (POST /api/app/sequence-tasks/:id/done|skip).
import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, SkipForward } from "lucide-react";
import { LINKEDIN_NOTE_MAX } from "@reachstack/shared";
import { errorMessage, get, post } from "@/lib/api";
import { ago } from "@/lib/format";
import { useCan } from "@/lib/session";
import { TaskIcon, TaskLinks, type TaskLead } from "@/components/sequence/task-steps";
import { LeadSheet } from "@/components/leads/LeadSheet";
import { Button, Callout, Card, CardHeader, CopyButton } from "@/components/ui";

export interface SequenceTask {
  id: string;
  kind: string | null;
  title: string;
  note: string | null;
  due_at: string | null;
  step: number;
  campaign: { id: string; name: string | null } | null;
  subsequence: { id: string; name: string | null } | null;
  lead: (TaskLead & { id: string; job_title: string | null }) | null;
}

export const sequenceTasksQuery = {
  queryKey: ["sequence-tasks"],
  queryFn: () => get<{ items: SequenceTask[]; total: number }>("/api/app/sequence-tasks"),
  refetchInterval: 60_000,
};

function TaskRow({ t, onOpenLead }: { t: SequenceTask; onOpenLead: (id: string) => void }) {
  const qc = useQueryClient();
  const can = useCan();
  const finish = useMutation({
    mutationFn: (outcome: "done" | "skip") => post<{ moved: boolean; finished: boolean }>(`/api/app/sequence-tasks/${t.id}/${outcome}`),
    onSuccess: (r, outcome) =>
      toast.success(outcome === "done" ? "Task done" : "Task skipped", {
        description: !r.moved ? "The lead had already moved on." : r.finished ? "That was the last step: the lead has finished the sequence." : "The lead goes on to the next step.",
      }),
    onError: (e) => toast.error(errorMessage(e)),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["sequence-tasks"] }),
  });
  const lead = t.lead;
  const name = lead?.name || lead?.email || "A deleted lead";
  const role = [lead?.job_title, lead?.company_name].filter(Boolean).join(" at ");
  const flow = t.subsequence
    ? { to: `/app/campaign/${t.campaign?.id}/subsequences/${t.subsequence.id}/sequences`, name: t.subsequence.name ?? "Subsequence" }
    : t.campaign
      ? { to: `/app/campaign/${t.campaign.id}/sequences`, name: t.campaign.name ?? "Campaign" }
      : null;

  return (
    <li className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-start">
      <span className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-text sm:flex">
        <TaskIcon kind={t.kind} size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 font-medium">
          <TaskIcon kind={t.kind} size={14} className="shrink-0 text-brand-text sm:hidden" />
          {t.title}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {lead ? (
            <button type="button" className="font-medium text-text hover:underline" onClick={() => onOpenLead(lead.id)}>
              {name}
            </button>
          ) : (
            name
          )}
          {role && ` · ${role}`}
          {flow && (
            <>
              {" · "}
              <Link to={flow.to} className="hover:underline">
                {flow.name}
              </Link>
              , step {t.step}
            </>
          )}
          {t.due_at && ` · due ${ago(t.due_at)}`}
        </p>
        <TaskLinks className="mt-2" kind={t.kind} lead={lead} onAddPhone={lead ? () => onOpenLead(lead.id) : undefined} />
        {t.note && (
          <div className="mt-2.5 rounded-lg border border-line bg-panel-2 px-3 py-2">
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 whitespace-pre-wrap break-words text-[13px]">{t.note}</p>
              <CopyButton value={t.note} label="Copy" className="shrink-0" />
            </div>
            {t.kind === "linkedin_connect" && t.note.length > LINKEDIN_NOTE_MAX && (
              <p className="mt-1 text-xs text-warn">
                {t.note.length} characters: LinkedIn takes {LINKEDIN_NOTE_MAX}. Shorten it before you send it.
              </p>
            )}
          </div>
        )}
      </div>
      {can.write && can.perm("edit_campaigns") && (
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="primary" icon={<Check size={14} />} loading={finish.isPending && finish.variables === "done"} disabled={finish.isPending} onClick={() => finish.mutate("done")}>
            Done
          </Button>
          <Button size="sm" icon={<SkipForward size={14} />} loading={finish.isPending && finish.variables === "skip"} disabled={finish.isPending} onClick={() => finish.mutate("skip")} title="Move the lead on without doing it">
            Skip
          </Button>
        </div>
      )}
    </li>
  );
}

/** The open tasks, oldest first. Shows nothing when there are none. */
export function SequenceTasks() {
  const q = useQuery(sequenceTasksQuery);
  const [sheet, setSheet] = useState<string | null>(null);
  if (q.isError) {
    return (
      <Callout tone="bad" title="Your tasks didn't load" action={<Button size="sm" onClick={() => void q.refetch()}>Retry</Button>}>
        {errorMessage(q.error)}
      </Callout>
    );
  }
  const r = q.data;
  if (!r?.total) return null;
  return (
    <Card padded={false}>
      <div className="border-b border-line px-4 py-3">
        <CardHeader
          className="mb-0"
          title={`Tasks (${r.total})`}
          description="What your sequences ask you to do by hand. Done or Skip moves the lead on to the next step; a lead who replies or stops meanwhile drops off this list."
        />
      </div>
      <ul className="divide-y divide-line">
        {r.items.map((t) => (
          <TaskRow key={t.id} t={t} onOpenLead={setSheet} />
        ))}
      </ul>
      {r.total > r.items.length && <p className="border-t border-line px-4 py-3 text-xs text-muted">Showing the {r.items.length} that have waited longest. The rest show up as these are done.</p>}
      <LeadSheet leadId={sheet} onClose={() => setSheet(null)} onChanged={() => void q.refetch()} />
    </Card>
  );
}
