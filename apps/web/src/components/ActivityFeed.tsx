import { Link } from "react-router";
import { AlertOctagon, CalendarCheck, Eye, Heart, MailX, MessageSquareReply, MousePointerClick, Sparkles } from "lucide-react";
import { INTEREST_STATUS_LABELS } from "@reachstack/shared";
import { useCursorList } from "@/lib/query";
import { ago } from "@/lib/format";
import { Button, EmptyState, ErrorState, Skeleton } from "@/components/ui";
import { cn } from "@/lib/cn";

export interface FeedItem {
  id: string;
  type: string;
  timestamp: string;
  lead_email: string | null;
  lead_name: string | null;
  company_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  account_email: string | null;
  url: string | null;
  value: number | null;
}

const META: Record<string, { icon: typeof Eye; tone: string; verb: (i: FeedItem) => string }> = {
  reply: { icon: MessageSquareReply, tone: "bg-brand-soft text-brand-text", verb: () => "replied" },
  auto_reply: { icon: MessageSquareReply, tone: "bg-panel-2 text-muted", verb: () => "sent an automatic reply" },
  open: { icon: Eye, tone: "bg-info-soft text-info", verb: () => "opened your email" },
  click: { icon: MousePointerClick, tone: "bg-info-soft text-info", verb: (i) => (i.url ? `clicked ${shortUrl(i.url)}` : "clicked a link") },
  bounce: { icon: AlertOctagon, tone: "bg-bad-soft text-bad", verb: () => "bounced" },
  unsubscribe: { icon: MailX, tone: "bg-warn-soft text-warn", verb: () => "unsubscribed" },
  opportunity: { icon: Sparkles, tone: "bg-ok-soft text-ok", verb: () => "became an opportunity" },
  interest_change: {
    icon: Heart,
    tone: "bg-ok-soft text-ok",
    verb: (i) => (i.value !== null && INTEREST_STATUS_LABELS[i.value] ? `was marked ${INTEREST_STATUS_LABELS[i.value]!.toLowerCase()}` : "changed status"),
  },
};

function shortUrl(u: string) {
  try {
    const x = new URL(u);
    return x.hostname + (x.pathname.length > 1 ? x.pathname.slice(0, 24) : "");
  } catch {
    return u.slice(0, 40);
  }
}

export function ActivityFeed({ campaignId, limit = 15, compact }: { campaignId?: string; limit?: number; compact?: boolean }) {
  const q = useCursorList<FeedItem>(["activity-feed", campaignId ?? "all"], "/api/app/activity-feed", { limit, campaign_id: campaignId }, { refetchInterval: 60_000 });
  if (q.isLoading)
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    );
  if (q.isError && !q.items.length) return <ErrorState className="py-10" title="Couldn't load the activity" error={q.error} onRetry={() => q.refetch()} />;
  if (!q.items.length) return <EmptyState className="py-10" icon={<CalendarCheck size={22} />} title="No activity yet" description="Replies, opens, clicks and new opportunities show up here as they happen." />;
  return (
    <div>
      <ol className="space-y-1">
        {q.items.map((i) => {
          const m = META[i.type] ?? META.reply!;
          const Icon = m.icon;
          const who = i.lead_name || i.lead_email || "A lead";
          return (
            <li key={i.id}>
              <Link
                to={i.lead_email ? `/app/unibox?search=${encodeURIComponent(i.lead_email)}` : "/app/unibox"}
                className="flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-panel-2"
              >
                <span className={cn("mt-0.5 rounded-md p-1.5", m.tone)}>
                  <Icon size={14} />
                </span>
                <span className="min-w-0 flex-1 text-[13px]">
                  <span className="font-medium">{who}</span>
                  {i.company_name && !compact && <span className="text-muted"> ({i.company_name})</span>} <span className="text-muted">{m.verb(i)}</span>
                  {i.campaign_name && <span className="block truncate text-xs text-faint">{i.campaign_name}</span>}
                </span>
                <span className="shrink-0 text-xs text-faint">{ago(i.timestamp)}</span>
              </Link>
            </li>
          );
        })}
      </ol>
      {q.hasNextPage && (
        <div className="mt-2 flex justify-center">
          <Button size="sm" variant="ghost" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
            Show more
          </Button>
        </div>
      )}
    </div>
  );
}
