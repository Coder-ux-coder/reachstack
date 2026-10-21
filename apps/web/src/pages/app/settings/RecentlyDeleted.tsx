import { useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { ArchiveRestore, GitBranch, List, MessageSquareText, RotateCcw, Send, Trash2, Users, type LucideIcon } from "lucide-react";
import { del, errorMessage, get, type Page } from "@/lib/api";
import { cn } from "@/lib/cn";
import { ago, dateTime, plural } from "@/lib/format";
import { usePageTitle } from "@/lib/hooks";
import { restoreDeleted } from "@/lib/recently-deleted";
import { Badge, Button, Callout, Card, EmptyState, NativeSelect, SkeletonRows, useConfirm } from "@/components/ui";
import { SettingsHeader } from "./parts";

type Kind = "campaign" | "lead_list" | "leads" | "template" | "subsequence";

interface Entry {
  id: string;
  kind: Kind;
  name: string;
  /** Where it was ("From “Q4 outreach”", "In “Webinar”", "Reply template"). */
  context: string | null;
  counts: Record<string, number>;
  deleted_at: string;
  deleted_by_name: string | null;
  expires_at: string;
  days_left: number;
  /** False for a moment while a big delete is still being stored. */
  ready: boolean;
  /** Restoring, or deleting for good, needs what deleting it needed. */
  can_restore: boolean;
}

const KINDS: Record<Kind, { label: string; icon: LucideIcon }> = {
  campaign: { label: "Campaign", icon: Send },
  lead_list: { label: "Lead list", icon: List },
  leads: { label: "Leads", icon: Users },
  template: { label: "Template", icon: MessageSquareText },
  subsequence: { label: "Subsequence", icon: GitBranch },
};

const FILTERS = [
  { value: "", label: "Everything" },
  { value: "campaign", label: "Campaigns" },
  { value: "lead_list", label: "Lead lists" },
  { value: "leads", label: "Leads" },
  { value: "template", label: "Templates" },
  { value: "subsequence", label: "Subsequences" },
];

/** What went with it: "2 leads · 1 subsequence". */
function contents(e: Entry): string {
  const parts: string[] = [];
  if (e.kind !== "leads" && e.counts.leads) parts.push(plural(e.counts.leads, "lead"));
  if (e.counts.subsequences) parts.push(plural(e.counts.subsequences, "subsequence"));
  return parts.join(" · ");
}

/** What "Delete forever" takes with it. */
function foreverNote(e: Entry): string {
  if (e.kind === "campaign") return "Its leads, subsequences and analytics are deleted for good. This can't be undone.";
  if (e.kind === "lead_list") return "Its leads are deleted for good. This can't be undone.";
  return "This can't be undone.";
}

function Row({ e, busy, onRestore, onForget }: { e: Entry; busy: "restore" | "forget" | null; onRestore: () => void; onForget: () => void }) {
  const kind = KINDS[e.kind] ?? KINDS.leads;
  const Icon = kind.icon;
  const details = [e.context, contents(e)].filter(Boolean).join(" · ");
  return (
    <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="mt-0.5 shrink-0 rounded-lg bg-panel-2 p-2 text-muted">
          <Icon size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="max-w-full truncate text-[13px] font-medium">{e.name}</span>
            <Badge>{kind.label}</Badge>
            {!e.ready && <Badge tone="warn">Still deleting</Badge>}
          </div>
          {details && <p className="mt-0.5 truncate text-xs text-muted">{details}</p>}
          <p className="mt-0.5 text-xs text-faint">
            <span title={dateTime(e.deleted_at)}>Deleted {ago(e.deleted_at)}</span>
            {e.deleted_by_name ? ` by ${e.deleted_by_name}` : ""}
            {" · "}
            <span className={cn(e.days_left <= 3 && "font-medium text-warn")} title={`Deleted for good on ${dateTime(e.expires_at)}`}>
              {e.days_left <= 1 ? "Last day to restore" : `${e.days_left} days left`}
            </span>
          </p>
        </div>
      </div>
      {e.can_restore && (
        <div className="flex shrink-0 flex-wrap gap-2 pl-11 sm:pl-0">
          <Button size="sm" icon={<RotateCcw size={14} />} loading={busy === "restore"} disabled={!e.ready || !!busy} onClick={onRestore}>
            Restore
          </Button>
          <Button size="sm" variant="ghost" className="text-bad hover:text-bad" icon={<Trash2 size={14} />} loading={busy === "forget"} disabled={!e.ready || !!busy} onClick={onForget}>
            Delete forever
          </Button>
        </div>
      )}
    </div>
  );
}

/** /app/settings/recently-deleted */
export default function RecentlyDeleted() {
  usePageTitle("Recently deleted");
  const qc = useQueryClient();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [kind, setKind] = useState("");
  const [busy, setBusy] = useState<{ id: string; what: "restore" | "forget" } | null>(null);
  const list = useInfiniteQuery({
    queryKey: ["recently-deleted", kind],
    queryFn: ({ pageParam, signal }) => get<Page<Entry>>("/api/app/recently-deleted", { kind: kind || undefined, starting_after: pageParam, limit: 50 }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.next_starting_after ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];

  const restore = async (e: Entry) => {
    setBusy({ id: e.id, what: "restore" });
    try {
      const r = await restoreDeleted(e.id);
      toast.success(r.message, r.link ? { duration: 8000, action: { label: "Open", onClick: () => navigate(r.link!) } } : undefined);
    } catch (err) {
      toast.error(errorMessage(err));
      await qc.invalidateQueries({ queryKey: ["recently-deleted"] });
    } finally {
      setBusy(null);
    }
  };

  const forget = async (e: Entry) => {
    if (!(await confirm({ title: `Delete “${e.name}” forever?`, description: foreverNote(e), confirmLabel: "Delete forever", danger: true }))) return;
    setBusy({ id: e.id, what: "forget" });
    try {
      await del(`/api/app/recently-deleted/${e.id}`);
      toast.success(`“${e.name}” is deleted for good`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      await qc.invalidateQueries({ queryKey: ["recently-deleted"] });
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <SettingsHeader
        title="Recently deleted"
        description="Deleted campaigns, lead lists, leads, templates and subsequences stay here for 30 days. Restore one to put it back as it was. A campaign that was sending comes back paused. After 30 days, items are deleted for good."
      />

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <NativeSelect size="sm" className="w-full sm:w-48" value={kind} onChange={setKind} options={FILTERS} aria-label="Show" />
        </div>
        {list.isError && (
          <div className="p-4">
            <Callout tone="bad">{errorMessage(list.error)}</Callout>
          </div>
        )}
        {list.isLoading ? (
          <SkeletonRows rows={4} />
        ) : (
          <div className="divide-y divide-line">
            {rows.map((e) => (
              <Row key={e.id} e={e} busy={busy?.id === e.id ? busy.what : null} onRestore={() => restore(e)} onForget={() => forget(e)} />
            ))}
          </div>
        )}
        {!list.isLoading && !list.isError && !rows.length && (
          <EmptyState
            className="py-12"
            icon={<ArchiveRestore size={20} />}
            title={kind ? "Nothing of this kind was deleted" : "Nothing deleted in the last 30 days"}
            description="When you delete a campaign, a lead list, leads, a template or a subsequence, it shows up here for 30 days."
          />
        )}
        {list.hasNextPage && (
          <div className="border-t border-line p-3 text-center">
            <Button size="sm" variant="ghost" loading={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
              Load more
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
