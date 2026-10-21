// /share/campaign?id=… — a campaign someone shared: anyone can read the sequence, and a signed-in user can import a
// copy into their workspace as a draft. Links stay open for 7 days after the campaign was last shared.
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Clock, Download, LinkIcon, Mail } from "lucide-react";
import { ApiError, errorMessage, get, post } from "@/lib/api";
import { useMe } from "@/lib/session";
import { Badge, Button, ButtonLink, EmptyState, Segmented, Skeleton } from "@/components/ui";
import { EmailFrame } from "@/components/EmailFrame";
import { TaskIcon, taskLabel } from "@/components/sequence/task-steps";
import { dateOnly, plural } from "@/lib/format";
import { PublicShell } from "./layout";

interface SharedCampaign {
  id: string;
  name: string;
  expires_at: string | null;
  steps: Array<{ step: number; type?: "email" | "task"; task?: string; delay: number; delay_unit: "minutes" | "hours" | "days"; variants: Array<{ subject: string; body: string }> }>;
}

function Step({ step, last, delay }: { step: SharedCampaign["steps"][number]; last: boolean; delay: string }) {
  const [v, setV] = useState(0);
  const variant = step.variants[v] ?? step.variants[0];
  if (step.type === "task") {
    return (
      <li>
        <div className="overflow-hidden rounded-xl border border-line bg-panel shadow-card">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 text-sm font-semibold sm:px-5">
            <TaskIcon kind={step.task} size={15} className="text-brand-text" /> Step {step.step}
            <span className="font-normal text-muted">· {taskLabel(step.task)}, done by hand</span>
          </div>
          <div className="px-4 py-4 text-[13px] sm:px-5">
            {variant?.subject?.trim() && <p className="font-medium">{variant.subject}</p>}
            {variant?.body?.trim() ? <p className="mt-1 whitespace-pre-wrap text-muted">{variant.body}</p> : !variant?.subject?.trim() && <p className="text-faint">No note.</p>}
          </div>
        </div>
        {!last && (
          <div className="flex items-center gap-2 py-3 pl-5 text-xs text-muted">
            <span className="h-5 w-px bg-line-strong" />
            <Clock size={13} /> Then wait {delay} after it's done
          </div>
        )}
      </li>
    );
  }
  return (
    <li>
      <div className="overflow-hidden rounded-xl border border-line bg-panel shadow-card">
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 sm:px-5">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Mail size={15} className="text-brand-text" /> Step {step.step}
          </span>
          {step.variants.length > 1 && (
            <Segmented
              size="sm"
              className="ml-auto"
              value={String(v)}
              onChange={(x) => setV(Number(x))}
              options={step.variants.map((_, i) => ({ value: String(i), label: `Variant ${String.fromCharCode(65 + i)}` }))}
            />
          )}
        </div>
        <div className="px-4 py-4 sm:px-5">
          <p className="text-[13px] text-muted">
            Subject:{" "}
            <span className="font-medium text-text">{variant?.subject?.trim() || (step.step > 1 ? "Same thread as the previous email" : "No subject")}</span>
          </p>
          <div className="mt-3 border-t border-line pt-3">{variant?.body?.trim() ? <EmailFrame html={variant.body} minHeight={60} /> : <p className="text-sm text-faint">This email is empty.</p>}</div>
        </div>
      </div>
      {!last && (
        <div className="flex items-center gap-2 py-3 pl-5 text-xs text-muted">
          <span className="h-5 w-px bg-line-strong" />
          <Clock size={13} /> Then wait {delay}
        </div>
      )}
    </li>
  );
}

export function ShareCampaign() {
  const [params] = useSearchParams();
  const id = params.get("id") ?? "";
  const me = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const shared = useQuery({
    queryKey: ["shared-campaign", id],
    queryFn: () => get<SharedCampaign>(`/api/public/share/campaign/${encodeURIComponent(id)}`),
    enabled: !!id,
    retry: false,
  });
  const signedIn = !!me.data && !me.data.session.mfa_pending;
  const here = `/share/campaign?id=${encodeURIComponent(id)}`;

  const importCopy = async () => {
    setBusy(true);
    try {
      const c = await post<{ id: string; name: string }>(`/api/v2/campaigns/${encodeURIComponent(id)}/from-export`);
      await qc.invalidateQueries({ queryKey: ["campaigns"] });
      toast.success(`Imported “${c.name}” as a draft`);
      nav(`/app/campaign/${c.id}/sequences`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const action = signedIn ? (
    me.data?.workspace ? (
      <Button variant="primary" icon={<Download size={15} />} loading={busy} onClick={importCopy} disabled={!shared.data}>
        Import a copy
      </Button>
    ) : (
      <ButtonLink to="/app/organization/create" variant="primary">
        Create a workspace first
      </ButtonLink>
    )
  ) : (
    <ButtonLink to={`/auth/login?next=${encodeURIComponent(here)}`} variant="primary">
      Log in to import
    </ButtonLink>
  );

  if (!id || shared.error)
    return (
      <PublicShell title="Shared campaign">
        <EmptyState
          icon={<LinkIcon size={26} />}
          title={!id || (shared.error instanceof ApiError && shared.error.status === 404) ? "This link has expired" : "Couldn't open this campaign"}
          description={
            !id || (shared.error instanceof ApiError && shared.error.status === 404)
              ? "Shared campaigns stay open for 7 days after they're shared. Ask the person who sent it for a new link."
              : errorMessage(shared.error)
          }
          action={
            <ButtonLink to={signedIn ? "/app/campaigns" : "/"} variant="secondary">
              {signedIn ? "Go to your campaigns" : "Go to the home page"}
            </ButtonLink>
          }
        />
      </PublicShell>
    );

  const c = shared.data;
  return (
    <PublicShell title={c ? `${c.name} · Shared campaign` : "Shared campaign"} actions={c ? action : undefined}>
      {!c ? (
        <div className="space-y-4">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-80" />
          <Skeleton className="mt-6 h-56 w-full" />
        </div>
      ) : (
        <>
          <div className="mb-6">
            <Badge tone="brand">Shared campaign</Badge>
            <h1 className="mt-2 break-words text-2xl font-semibold tracking-tight">{c.name}</h1>
            <p className="mt-1.5 text-[13px] text-muted">
              {plural(c.steps.length, "step")}
              {c.expires_at && <> · You can import it until {dateOnly(c.expires_at)}</>}
            </p>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
              {signedIn
                ? "Import a copy and it lands in your workspace as a draft, with the same steps and settings. You add your own leads and sending accounts."
                : "Someone shared this sequence with you. Log in to import a copy into your workspace, or create a free account first and come back to this link."}
            </p>
            {!signedIn && (
              <ButtonLink to="/auth/signup" variant="link" className="mt-1 px-0">
                Create a free account
              </ButtonLink>
            )}
          </div>
          {c.steps.length ? (
            <ol>
              {c.steps.map((s, i) => (
                <Step key={s.step} step={s} last={i === c.steps.length - 1} delay={plural(s.delay, s.delay_unit.replace(/s$/, ""))} />
              ))}
            </ol>
          ) : (
            <EmptyState icon={<Mail size={24} />} title="No emails yet" description="This campaign doesn't have any steps. You can still import it and write them yourself." />
          )}
          <div className="mt-8 flex justify-center">{action}</div>
        </>
      )}
    </PublicShell>
  );
}
