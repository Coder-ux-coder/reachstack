// Unsubscribe pages reached from a campaign email: /email-marketing/unsubscribe stops everything from the sender,
// /broadcasts/unsubscribe only the campaign the email belongs to. Both take the email's ?token=. The plain /u/ page
// on the tracking domain handles the usual case; these offer the choice.
import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, MailX, XCircle } from "lucide-react";
import { ApiError, errorMessage, get, post } from "@/lib/api";
import { Button, Callout, Spinner } from "@/components/ui";
import { cn } from "@/lib/cn";
import { CardPage } from "./layout";

interface LinkInfo {
  email: string;
  from: string;
  has_campaign: boolean;
  unsubscribed: { all: boolean; campaign: boolean };
}

type Scope = "all" | "campaign";

const pathFor = (scope: Scope, token: string) => `${scope === "all" ? "/email-marketing/unsubscribe" : "/broadcasts/unsubscribe"}?token=${encodeURIComponent(token)}`;

function Icon({ tone, children }: { tone: "ok" | "bad" | "brand"; children: ReactNode }) {
  return <div className={cn("mx-auto mb-5 w-fit rounded-2xl p-3.5", tone === "ok" ? "bg-ok-soft text-ok" : tone === "bad" ? "bg-bad-soft text-bad" : "bg-brand-soft text-brand-text")}>{children}</div>;
}

function UnsubscribePage({ scope }: { scope: Scope }) {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const info = useQuery({
    queryKey: ["unsubscribe", token],
    queryFn: () => get<LinkInfo>(`/api/public/unsubscribe/${encodeURIComponent(token)}`),
    enabled: !!token,
    retry: false,
    staleTime: Infinity,
  });
  const qc = useQueryClient();
  const [done, setDone] = useState<Scope | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const title = scope === "all" ? "Unsubscribe" : "Unsubscribe from this campaign";
  if (token && info.isLoading)
    return (
      <CardPage title={title}>
        <div className="flex justify-center py-10">
          <Spinner size={22} />
        </div>
      </CardPage>
    );
  if (!token || info.error || !info.data)
    return (
      <CardPage title="Link expired">
        <Icon tone="bad">
          <XCircle size={30} strokeWidth={1.6} />
        </Icon>
        <h1 className="text-xl font-semibold">This link doesn't work anymore</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          {info.error && !(info.error instanceof ApiError && info.error.status === 404) ? errorMessage(info.error) : "Use the unsubscribe link in the most recent email you received."}
        </p>
      </CardPage>
    );

  const d = info.data;
  // Campaign-only makes no sense for an email outside a campaign.
  const effective: Scope = scope === "campaign" && !d.has_campaign ? "all" : scope;
  const stopped = done ?? (d.unsubscribed.all ? "all" : d.unsubscribed.campaign && effective === "campaign" ? "campaign" : null);

  if (stopped)
    return (
      <CardPage title="You're unsubscribed">
        <Icon tone="ok">
          <CheckCircle2 size={30} strokeWidth={1.6} />
        </Icon>
        <h1 className="text-xl font-semibold">You're unsubscribed</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          {stopped === "all" ? (
            <>
              <b className="text-text">{d.email}</b> won't get any more emails from this sender.
            </>
          ) : (
            <>
              <b className="text-text">{d.email}</b> won't get any more emails from this campaign.
            </>
          )}
        </p>
        {stopped === "campaign" && (
          <Link to={pathFor("all", token)} className="mt-5 inline-block text-[13px] font-medium text-brand-text hover:underline">
            Stop all emails from this sender
          </Link>
        )}
        <Footer />
      </CardPage>
    );

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/public/unsubscribe/${encodeURIComponent(token)}`, { scope: effective });
      setDone(effective);
      // The other page reads the same answer.
      void qc.invalidateQueries({ queryKey: ["unsubscribe", token] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <CardPage title={title}>
      <Icon tone="brand">
        <MailX size={28} strokeWidth={1.6} />
      </Icon>
      <h1 className="text-xl font-semibold">{effective === "all" ? "Unsubscribe from this sender?" : "Stop this campaign's emails?"}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        {effective === "all" ? (
          <>
            You won't get any more emails at <b className="text-text">{d.email}</b> from this sender, whichever address they write from.
          </>
        ) : (
          <>
            You won't get the rest of this campaign at <b className="text-text">{d.email}</b>. The sender may still write to you about something else.
          </>
        )}
      </p>
      <p className="mt-2 text-xs text-faint">The email came from {d.from}.</p>
      {error && (
        <Callout tone="bad" className="mt-4 text-left">
          {error}
        </Callout>
      )}
      <Button variant="primary" size="lg" className="mt-6 w-full" loading={busy} onClick={run}>
        {effective === "all" ? "Unsubscribe" : "Unsubscribe from this campaign"}
      </Button>
      {effective === "all" && d.has_campaign && !d.unsubscribed.campaign && (
        <Link to={pathFor("campaign", token)} className="mt-4 inline-block text-[13px] font-medium text-brand-text hover:underline">
          Only stop this campaign
        </Link>
      )}
      {effective === "campaign" && (
        <Link to={pathFor("all", token)} className="mt-4 inline-block text-[13px] font-medium text-brand-text hover:underline">
          Stop all emails from this sender instead
        </Link>
      )}
      <Footer />
    </CardPage>
  );
}

function Footer() {
  return (
    <p className="mt-6 border-t border-line pt-4 text-xs leading-relaxed text-faint">
      Never asked for these emails?{" "}
      <Link to="/privacy/report-abuse" className="text-muted underline-offset-2 hover:underline">
        Report them
      </Link>{" "}
      or{" "}
      <Link to="/privacy/opt-out" className="text-muted underline-offset-2 hover:underline">
        remove your profile
      </Link>
      .
    </p>
  );
}

// Keyed by token so that opening another email's link starts over.

/** /email-marketing/unsubscribe?token=… */
export function SenderUnsubscribe() {
  const [params] = useSearchParams();
  return <UnsubscribePage key={params.get("token") ?? ""} scope="all" />;
}

/** /broadcasts/unsubscribe?token=… */
export function CampaignUnsubscribe() {
  const [params] = useSearchParams();
  return <UnsubscribePage key={params.get("token") ?? ""} scope="campaign" />;
}
