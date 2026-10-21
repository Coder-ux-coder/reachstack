// The bell in the app header: this person's notifications in the current workspace (mailbox problems, positive
// replies, paused, stalled and finished campaigns, sending paused after a restore, due reminders and tasks), newest first. Opening one marks it read and
// goes to what it's about. Browser notifications for new ones are opt-in per browser (lib/notifications.ts).
import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlarmClock, Bell, Bot, CheckCheck, ChevronRight, CirclePause, Flag, ListTodo, MailWarning, Package, ShieldAlert, ThumbsUp, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { errorMessage, get, post } from "@/lib/api";
import { ago, num } from "@/lib/format";
import { showBrowserNotification, useBrowserNotifications } from "@/lib/notifications";
import { useBrand, useCan, useSession } from "@/lib/session";
import { Badge, Button, EmptyState, Popover, Skeleton, Switch } from "@/components/ui";

interface AppNotification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  created_at: string;
}

interface NotificationPage {
  items: AppNotification[];
  unread: number;
  next_before: string | null;
}

type Pages = InfiniteData<NotificationPage, string | null>;

const TYPES: Record<string, { icon: LucideIcon; tone: string }> = {
  account_error: { icon: MailWarning, tone: "bg-bad-soft text-bad" },
  bounce_protect: { icon: ShieldAlert, tone: "bg-bad-soft text-bad" },
  campaign_stalled: { icon: CirclePause, tone: "bg-warn-soft text-warn" },
  sending_paused: { icon: CirclePause, tone: "bg-warn-soft text-warn" },
  positive_reply: { icon: ThumbsUp, tone: "bg-ok-soft text-ok" },
  campaign_completed: { icon: Flag, tone: "bg-ok-soft text-ok" },
  reminder_due: { icon: AlarmClock, tone: "bg-info-soft text-info" },
  task_due: { icon: ListTodo, tone: "bg-info-soft text-info" },
  dfy_order: { icon: Package, tone: "bg-panel-2 text-muted" },
  dfy_ready: { icon: Package, tone: "bg-ok-soft text-ok" },
  copilot_task: { icon: Bot, tone: "bg-brand-soft text-brand-text" },
};
const OTHER = { icon: Bell, tone: "bg-panel-2 text-muted" };

/** More new ones than this at once become a single browser notification. */
const MAX_POPUPS = 3;

function Row({ n, onOpen }: { n: AppNotification; onOpen: (n: AppNotification) => void }) {
  const t = TYPES[n.type] ?? OTHER;
  const Icon = t.icon;
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(n)}
        className={cn("flex w-full gap-3 px-3 py-2.5 text-left transition-colors hover:bg-panel-2 focus-visible:bg-panel-2 focus-visible:outline-none", !n.read && "bg-brand-soft/50")}
      >
        <span className={cn("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full", t.tone)}>
          <Icon size={14} />
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn("block break-words text-[13px] leading-snug", n.read ? "text-muted" : "font-medium text-text")}>
            {!n.read && <span className="sr-only">Unread: </span>}
            {n.title}
          </span>
          {n.body && <span className="mt-0.5 line-clamp-2 block break-words text-xs leading-snug text-muted">{n.body}</span>}
          <span className="mt-1 block text-[11px] text-faint">{ago(n.created_at)}</span>
        </span>
        {!n.read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand" aria-hidden />}
      </button>
    </li>
  );
}

export function NotificationBell() {
  const me = useSession();
  const can = useCan();
  const brand = useBrand();
  const nav = useNavigate();
  const qc = useQueryClient();
  const browser = useBrowserNotifications();
  const switchId = useId();
  const [open, setOpen] = useState(false);
  const ws = me.workspace?.id ?? null;
  const key = ["notifications", ws];

  const q = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => get<NotificationPage>("/api/app/notifications", { limit: 20, before: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_before,
    enabled: !!ws,
    refetchInterval: 30_000,
    // Browser notifications need the list kept fresh while the tab is in the background too.
    refetchIntervalInBackground: browser.enabled,
  });
  // Mailboxes with an error right now (a state, not an event), as the bell showed before.
  const accounts = useQuery({
    queryKey: ["accounts", "summary"],
    queryFn: () => get<{ errors: number; total: number }>("/api/app/accounts/summary"),
    enabled: can.perm("accounts"),
  });
  const errors = accounts.data?.errors ?? 0;
  const first = q.data?.pages[0];
  const unread = first?.unread ?? 0;
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  const patchCache = (item: (n: AppNotification) => AppNotification, count: (unread: number) => number) =>
    qc.setQueryData<Pages>(key, (d) => d && { ...d, pages: d.pages.map((p) => ({ ...p, unread: count(p.unread), items: p.items.map(item) })) });

  const openItem = (n: AppNotification) => {
    onOpenChange(false);
    if (!n.read) {
      patchCache((x) => (x.id === n.id ? { ...x, read: true } : x), (u) => Math.max(0, u - 1));
      post<{ unread: number }>(`/api/app/notifications/${n.id}/read`)
        .then((r) => patchCache((x) => x, () => r.unread))
        .catch(() => qc.invalidateQueries({ queryKey: key }));
    }
    if (n.link) nav(n.link);
  };

  const markAll = async () => {
    patchCache((x) => ({ ...x, read: true }), () => 0);
    try {
      await post("/api/app/notifications/read-all");
    } catch (e) {
      toast.error(errorMessage(e));
      qc.invalidateQueries({ queryKey: key });
    }
  };

  // New unread ones since the last look become browser notifications, while this tab isn't the one in front. The ones
  // already there when the page loaded don't.
  const seen = useRef<{ ws: string | null; id: string } | null>(null);
  useEffect(() => {
    if (!first) return;
    const prev = seen.current;
    const top = first.items[0]?.id ?? "";
    seen.current = { ws, id: prev && prev.ws === ws && prev.id > top ? prev.id : top };
    if (!prev || prev.ws !== ws || !browser.enabled) return;
    if (document.visibilityState === "visible" && document.hasFocus()) return;
    const fresh = first.items.filter((n) => !n.read && n.id > prev.id);
    if (fresh.length > MAX_POPUPS) {
      showBrowserNotification({ id: `rs-new-${fresh[0]!.id}`, title: `${fresh.length} new notifications`, body: fresh.slice(0, 2).map((n) => n.title).join("\n") }, () => setOpen(true));
    } else {
      for (const n of [...fresh].reverse()) showBrowserNotification(n, () => openItem(n));
    }
  }, [first]); // eslint-disable-line react-hooks/exhaustive-deps

  const onOpenChange = (v: boolean) => {
    setOpen(v);
    if (v) void q.refetch();
    // Back to the first page, so polling doesn't reload every page that was opened.
    else qc.setQueryData<Pages>(key, (d) => (d && d.pages.length > 1 ? { pages: d.pages.slice(0, 1), pageParams: d.pageParams.slice(0, 1) } : d));
  };

  const toggleBrowser = async (on: boolean) => {
    const answer = await browser.setEnabled(on);
    if (!on) return;
    if (answer === "granted") toast.success("Browser notifications are on for this browser");
    else if (answer === "denied") toast.error("Your browser blocks notifications for this site. Allow them in its site settings, then try again.");
    else if (answer === "unsupported") toast.error("This browser can't show notifications.");
  };

  const browserHint =
    browser.permission === "unsupported" ? "Not available in this browser" : browser.permission === "denied" ? "Blocked in this browser's site settings" : `On this browser, while ${brand} is open in a tab`;

  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      align="end"
      collisionPadding={8}
      className="flex max-h-[min(36rem,var(--radix-popover-content-available-height))] w-[min(24rem,calc(100vw-1rem))] flex-col overflow-hidden p-0"
      trigger={
        <button
          type="button"
          className="relative rounded-lg p-2 text-muted hover:bg-panel-2 hover:text-text data-[state=open]:bg-panel-2 data-[state=open]:text-text"
          aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        >
          <Bell size={18} />
          {unread > 0 ? (
            <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-semibold leading-none tabular-nums text-on-brand ring-2 ring-panel">
              {unread > 9 ? "9+" : unread}
            </span>
          ) : errors > 0 ? (
            <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-bad" />
          ) : null}
        </button>
      }
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line py-2 pl-3 pr-2">
        <h2 className="text-sm font-semibold">Notifications</h2>
        {unread > 0 && <Badge tone="brand">{unread > 99 ? "99+" : num(unread)} new</Badge>}
        {unread > 0 && (
          <Button size="xs" variant="ghost" className="ml-auto" icon={<CheckCheck size={13} />} onClick={markAll}>
            Mark all read
          </Button>
        )}
      </div>

      {errors > 0 && (
        <button
          type="button"
          onClick={() => {
            onOpenChange(false);
            nav("/app/accounts?status=errors");
          }}
          className="flex w-full shrink-0 items-center gap-2.5 border-b border-line bg-bad-soft px-3 py-2 text-left text-[13px] font-medium text-bad hover:brightness-95 dark:hover:brightness-125"
        >
          <MailWarning size={14} className="shrink-0" />
          <span className="min-w-0 flex-1">{errors === 1 ? "1 email account needs attention" : `${num(errors)} email accounts need attention`}</span>
          <ChevronRight size={14} className="shrink-0" />
        </button>
      )}

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {q.isLoading ? (
          <div className="space-y-4 p-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="h-7 w-7 shrink-0 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : q.isError && !items.length ? (
          <div className="px-4 py-8 text-center text-[13px] text-muted">
            <p>Couldn't load your notifications.</p>
            <Button size="xs" className="mt-3" onClick={() => q.refetch()}>
              Try again
            </Button>
          </div>
        ) : !items.length ? (
          <EmptyState className="px-6 py-10" icon={<Bell size={20} />} title="You're all caught up" description="Mailbox problems, positive replies, finished campaigns and due reminders show up here." />
        ) : (
          <ul className="divide-y divide-line">
            {items.map((n) => (
              <Row key={n.id} n={n} onOpen={openItem} />
            ))}
          </ul>
        )}
        {q.hasNextPage && (
          <div className="border-t border-line p-1.5">
            <Button size="xs" variant="ghost" className="w-full" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
              Show older
            </Button>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-3 border-t border-line px-3 py-2.5">
        <label htmlFor={switchId} className="min-w-0 flex-1 cursor-pointer text-xs font-medium">
          Browser notifications
          <span className="block font-normal text-faint">{browserHint}</span>
        </label>
        <Switch id={switchId} size="sm" checked={browser.enabled} onChange={toggleBrowser} disabled={browser.permission === "unsupported" || browser.permission === "denied"} />
      </div>
    </Popover>
  );
}
