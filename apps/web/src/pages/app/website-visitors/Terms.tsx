// /user/sign-website-visitor-tos: the website visitor terms an owner or admin accepts before domains can be added.
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage, get, post } from "@/lib/api";
import { dateOnly } from "@/lib/format";
import { usePageTitle } from "@/lib/hooks";
import { useBrand, useCan } from "@/lib/session";
import { BrandMark } from "@/components/shell/AppShell";
import { Button, Callout, Card, Checkbox, SkeletonRows } from "@/components/ui";
import { invalidateVisitors, VW_KEY, type Terms } from "./api";

/** Only paths inside the app; anything else falls back to the setup page. */
function safeNext(raw: string | null) {
  return raw && raw.startsWith("/app/") && !raw.startsWith("//") ? raw : "/app/website-visitors/setup";
}

export function VisitorTerms() {
  usePageTitle("Website visitor terms");
  const brand = useBrand();
  const can = useCan();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: [...VW_KEY, "terms"], queryFn: () => get<Terms>("/api/app/website-visitors/terms") });

  const accept = async () => {
    setBusy(true);
    try {
      await post("/api/app/website-visitors/terms/accept");
      await invalidateVisitors(qc);
      toast.success("Terms accepted");
      nav(next, { replace: true });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const points = [
    "You'll only install the snippet on websites you own or are allowed to manage.",
    "Your privacy notice will say that you use visitor analytics that look up the company behind a visitor's IP address.",
    "Where the law requires consent before this kind of tracking (for example under the ePrivacy rules in the EU and UK), you'll load the snippet only after a visitor agrees.",
    "The snippet sets no cookies, keeps a random ID in the browser's local storage, and stays off for browsers that send Do Not Track or Global Privacy Control.",
    `Identification is company-level. ${brand} doesn't identify the person browsing; a "best contact" is a suggestion from your lead data, not someone who visited.`,
    "Visitor IP addresses are sent to the IP lookup service set up for your workspace (ipinfo.io) and deleted from this workspace once looked up, or after 30 days.",
    "You're responsible for how you contact anyone you add from website visits, including honoring opt-out requests and the anti-spam laws that apply to you.",
  ];

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <Card className="w-full max-w-xl p-6 sm:p-8">
        <BrandMark size={32} />
        {q.isLoading ? (
          <SkeletonRows rows={4} />
        ) : (
          <>
            <h1 className="mt-5 text-xl font-semibold tracking-tight">{q.data?.accepted ? "Website visitor terms" : "Accept the website visitor terms"}</h1>
            <p className="mt-1.5 text-sm text-muted">To use website visitors, your workspace agrees to the following (version {q.data?.version ?? ""}).</p>
            <ol className="mt-5 list-decimal space-y-2.5 pl-5 text-[13px] leading-relaxed">
              {points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ol>
            {q.data?.accepted ? (
              <>
                <Callout tone="ok" className="mt-6">
                  Accepted{q.data.accepted_by ? ` by ${q.data.accepted_by}` : ""}
                  {q.data.accepted_at ? ` on ${dateOnly(q.data.accepted_at)}` : ""}.
                </Callout>
                <div className="mt-6 flex justify-end">
                  <Button variant="primary" onClick={() => nav(next)}>
                    Continue
                  </Button>
                </div>
              </>
            ) : can.admin ? (
              <>
                <Checkbox className="mt-6" checked={agreed} onChange={setAgreed} label="I have read and agree to these terms" />
                <div className="mt-6 flex flex-wrap justify-end gap-2">
                  <Button onClick={() => nav("/app/website-visitors")}>Not now</Button>
                  <Button variant="primary" disabled={!agreed} loading={busy} onClick={() => void accept()}>
                    Accept and continue
                  </Button>
                </div>
              </>
            ) : (
              <>
                <Callout tone="info" className="mt-6">
                  An owner or admin of this workspace needs to accept these terms before your team can use website visitors.
                </Callout>
                <div className="mt-6 flex justify-end">
                  <Button onClick={() => nav("/app/website-visitors")}>Back</Button>
                </div>
              </>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
