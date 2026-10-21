import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { get } from "@/lib/api";
import type { DateRange } from "@/lib/dates";
import { dateTime, downloadBlob, num } from "@/lib/format";
import { Badge, Button, ErrorState, Skeleton } from "@/components/ui";
import { ScrollX } from "@/components/ui/scroll-x";
import { toCsv } from "@/lib/csv";

interface BounceItem {
  lead_email: string | null;
  type: "hard" | "soft";
  reason: string;
  reason_label: string;
  code: string | null;
  diagnostic: string | null;
  mailbox: string | null;
  step: number | null;
  subsequence_id: string | null;
  timestamp: string;
}

interface BounceReport {
  totals: { hard: number; soft: number };
  complete: boolean;
  reasons: Array<{ reason: string; label: string; hard: number; soft: number }>;
  /** `tried`: emails sent, and tries the receiving server refused at once (never sent, yet bounced). */
  mailboxes: Array<{ email: string; sent: number; tried: number; hard: number; soft: number; hard_rate: number }>;
  steps: Array<{ step: number; sent: number; tried: number; hard: number; soft: number }>;
  items: BounceItem[];
}

const SHOWN = 25;

function Breakdown({ title, head, rows, empty }: { title: string; head: string[]; rows: ReactNode[][]; empty: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-line">
      <p className="border-b border-line px-3 py-2 text-xs font-medium text-muted">{title}</p>
      {rows.length ? (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-xs text-faint">
              {head.map((h, i) => (
                <th key={h} className={i ? "px-3 py-1.5 text-right font-medium" : "px-3 py-1.5 font-medium"}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri} className="border-t border-line">
                {r.map((cell, i) => (
                  <td key={i} className={i ? "px-3 py-1.5 text-right tabular-nums" : "max-w-[12rem] truncate px-3 py-1.5"}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="px-3 py-4 text-center text-xs text-muted">{empty}</p>
      )}
    </div>
  );
}

/** Campaign analytics → Bounces: why emails bounced, by reason, mailbox and step, with a CSV of every bounce. */
export function BouncesPanel({ campaignId, campaignName, range }: { campaignId: string; campaignName: string; range: DateRange }) {
  const q = useQuery({
    queryKey: ["campaign", campaignId, "bounces", range.start_date, range.end_date],
    queryFn: () => get<BounceReport>(`/api/app/campaigns/${campaignId}/bounces`, { start_date: range.start_date, end_date: range.end_date, limit: 5000 }),
  });
  const r = q.data;
  if (q.isLoading) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-32" />
      </div>
    );
  }
  if (q.isError && !r) return <ErrorState className="py-10" title="Couldn't load the bounces" error={q.error} onRetry={() => q.refetch()} />;
  if (!r || !r.items.length) return <p className="px-4 py-10 text-center text-[13px] text-muted">No bounces in this period.</p>;

  const downloadCsv = () => {
    const csv = toCsv(
      r.items.map((i) => ({
        lead_email: i.lead_email ?? "",
        type: i.type,
        reason: i.reason_label,
        code: i.code ?? "",
        server_message: i.diagnostic ?? "",
        mailbox: i.mailbox ?? "",
        step: i.step !== null ? (i.subsequence_id ? `subsequence step ${i.step + 1}` : i.step + 1) : "",
        bounced_at: i.timestamp,
      })),
    );
    downloadBlob(`${campaignName.replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "") || "campaign"}-bounces.csv`, csv);
  };

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-0.5 text-[13px]">
          <p>
            <span className="font-semibold tabular-nums">{num(r.totals.hard)}</span> hard {r.totals.hard === 1 ? "bounce" : "bounces"} ·{" "}
            <span className="font-semibold tabular-nums">{num(r.totals.soft)}</span> soft
          </p>
          <p className="text-xs text-muted">Hard: the address doesn't work, so the lead stops. Soft: a passing problem like a full mailbox; the lead isn't stopped.</p>
          <p className="text-xs text-muted">Emails: those sent, and those the receiving server refused outright.</p>
        </div>
        <Button size="sm" icon={<Download size={14} />} onClick={downloadCsv}>
          Download CSV
        </Button>
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <Breakdown title={r.complete ? "By reason" : `By reason (newest ${num(r.items.length)})`} head={["Reason", "Hard", "Soft"]} rows={r.reasons.map((x) => [x.label, num(x.hard), num(x.soft)])} empty="No reasons recorded." />
        <Breakdown
          title="By mailbox"
          head={["Mailbox", "Emails", "Hard"]}
          rows={r.mailboxes.map((x) => [
            <span title={x.email}>{x.email}</span>,
            num(x.tried),
            <>
              {num(x.hard)} <span className="text-faint">{x.hard_rate}%</span>
            </>,
          ])}
          empty="No mailbox recorded."
        />
        <Breakdown title="By step" head={["Step", "Emails", "Hard"]} rows={r.steps.map((x) => [`Step ${x.step + 1}`, num(x.tried), num(x.hard)])} empty="Only subsequence emails bounced." />
      </div>
      <div className="min-w-0 rounded-lg border border-line">
        <p className="border-b border-line px-3 py-2 text-xs font-medium text-muted">
          Newest bounces{r.items.length > SHOWN ? ` (${SHOWN} of ${num(r.items.length)}; the CSV has ${r.complete ? "them all" : `the newest ${num(r.items.length)}`})` : ""}
        </p>
        <ScrollX>
          <table className="w-full min-w-[640px] text-[13px]">
            <tbody>
              {r.items.slice(0, SHOWN).map((i, n) => (
                <tr key={n} className="border-t border-line first:border-0">
                  <td className="max-w-[14rem] truncate px-3 py-2 font-medium">{i.lead_email ?? "Unknown lead"}</td>
                  <td className="px-3 py-2">
                    <Badge tone={i.type === "hard" ? "bad" : "warn"}>{i.type === "hard" ? "Hard" : "Soft"}</Badge>
                  </td>
                  <td className="max-w-[18rem] px-3 py-2" title={i.diagnostic ?? undefined}>
                    <span className="block truncate">{i.reason_label}</span>
                    {(i.code || i.diagnostic) && <span className="block truncate text-xs text-muted">{[i.code, i.diagnostic].filter(Boolean).join(" · ")}</span>}
                  </td>
                  <td className="max-w-[12rem] truncate px-3 py-2 text-muted">{i.mailbox ?? "–"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted">{i.step !== null ? `${i.subsequence_id ? "Sub. step" : "Step"} ${i.step + 1}` : "–"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-muted">{dateTime(i.timestamp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollX>
      </div>
    </div>
  );
}
