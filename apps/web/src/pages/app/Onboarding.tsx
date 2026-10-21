import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { errorMessage, get, post } from "@/lib/api";
import { ME_KEY, resendConfirmation, useMe, useSession } from "@/lib/session";
import { usePageTitle } from "@/lib/hooks";
import { cn } from "@/lib/cn";
import { BrandMark } from "@/components/shell/AppShell";
import { Button, ButtonLink, Card, FullPageSpinner, Input, Page, PageHeader, Progress } from "@/components/ui";

const QUESTIONS = [
  { key: "role", q: "What best describes you?", options: ["Founder / owner", "Sales leader", "Sales rep / SDR", "Marketer", "Agency / consultant", "Recruiter", "Other"] },
  { key: "team_size", q: "How big is your team?", options: ["Just me", "2–10", "11–50", "51–200", "200+"] },
  { key: "goal", q: "What do you want to do first?", options: ["Book more meetings", "Find new leads", "Warm up my inboxes", "Run outreach for clients", "Hire talent", "Something else"] },
  { key: "experience", q: "Have you run cold email before?", options: ["Never", "A little", "Yes, at scale"] },
  { key: "source", q: "How did you hear about us?", options: ["Search engine", "Friend or colleague", "Social media", "YouTube", "Podcast or newsletter", "Other"] },
] as const;

/** /app/signup-know-user — a few questions after sign-up; answers tailor the checklist. */
export function KnowUser() {
  const me = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [other, setOther] = useState("");
  const [busy, setBusy] = useState(false);
  usePageTitle("Welcome");
  if (me.isLoading) return <FullPageSpinner />;
  const q = QUESTIONS[step]!;
  const finish = async (final: Record<string, string>) => {
    setBusy(true);
    try {
      await post("/api/app/auth/onboarding", { answers: final });
      await qc.invalidateQueries({ queryKey: ME_KEY });
    } catch {
      // Answers are optional; never block someone from reaching the app.
    } finally {
      nav("/app/onboarding", { replace: true });
    }
  };
  const choose = (value: string) => {
    const next = { ...answers, [q.key]: value };
    setAnswers(next);
    setOther("");
    if (step + 1 < QUESTIONS.length) setStep(step + 1);
    else finish(next);
  };
  return (
    <div className="flex min-h-full flex-col items-center px-5 py-10">
      <BrandMark size={36} />
      <div className="mt-8 w-full max-w-lg">
        <Progress value={step} max={QUESTIONS.length} className="mb-8" />
        <p className="text-[13px] text-muted">
          Question {step + 1} of {QUESTIONS.length}
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{q.q}</h1>
        <div className="mt-6 grid gap-2 sm:grid-cols-2">
          {q.options.map((o) => (
            <button
              key={o}
              type="button"
              disabled={busy}
              onClick={() => (o === "Other" || o === "Something else" ? setOther(" ") : choose(o))}
              className={cn(
                "rounded-xl border bg-panel px-4 py-3 text-left text-sm font-medium transition-colors hover:border-brand hover:bg-brand-soft",
                answers[q.key] === o ? "border-brand bg-brand-soft" : "border-line",
              )}
            >
              {o}
            </button>
          ))}
        </div>
        {other && (
          <form
            className="mt-4 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (other.trim()) choose(other.trim());
            }}
          >
            <Input autoFocus value={other.trimStart()} onChange={(e) => setOther(e.target.value || " ")} placeholder="Tell us more" />
            <Button type="submit" variant="primary">
              Next
            </Button>
          </form>
        )}
        <div className="mt-8 flex justify-between">
          <Button variant="ghost" disabled={step === 0} onClick={() => setStep(step - 1)}>
            Back
          </Button>
          <Button variant="ghost" onClick={() => finish(answers)} loading={busy}>
            Skip for now
          </Button>
        </div>
      </div>
    </div>
  );
}

const CHECKLIST: Array<{ key: string; title: string; body: string; to?: string; cta: string }> = [
  { key: "verify_email", title: "Confirm your email", body: "We sent you a link when you signed up. Confirming keeps your account recoverable.", cta: "Resend link" },
  { key: "connect_account", title: "Connect your sending accounts", body: "Add Google, Microsoft or any IMAP/SMTP mailbox. More mailboxes means more volume at safe per-inbox limits.", to: "/app/account/connect", cta: "Connect account" },
  { key: "enable_warmup", title: "Warm up every new mailbox", body: "Warmup sends and replies to real conversations inside the pool so inbox providers learn to trust you. Give new domains about two weeks.", to: "/app/accounts", cta: "Manage warmup" },
  { key: "create_campaign", title: "Write your sequence", body: "Set up the emails, follow-up delays, sending schedule and options for a campaign.", to: "/app/campaign/create", cta: "New campaign" },
  { key: "add_leads", title: "Add leads", body: "Upload a CSV, paste emails or search the lead finder, then add them to the campaign.", to: "/app/lead-finder", cta: "Find leads" },
  { key: "launch_campaign", title: "Launch", body: "Run the pre-launch check, then start sending. You can pause any time.", to: "/app/campaigns", cta: "Open campaigns" },
  { key: "first_reply", title: "Handle replies", body: "Replies from every mailbox land in the unified inbox, labelled by interest.", to: "/app/unibox", cta: "Open inbox" },
];

/** /app/onboarding — the getting-started checklist. */
export default function Onboarding() {
  usePageTitle("Getting started");
  const me = useSession();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [hiding, setHiding] = useState(false);
  const setup = useQuery({ queryKey: ["dashboard", "setup"], queryFn: () => get<{ steps: Array<{ key: string; done: boolean }>; completed: number; total: number }>("/api/app/dashboard/setup") });
  const done = new Map(setup.data?.steps.map((s) => [s.key, s.done]));
  // Confirming the address takes an email the installation can send, so without one that step isn't on the list.
  const steps = CHECKLIST.filter((c) => c.key !== "verify_email" || me.features.system_smtp);
  // Marks the checklist done, which hides "Get set up" on the dashboard.
  const hide = async () => {
    setHiding(true);
    try {
      await post("/api/app/auth/onboarding", { answers: {}, completed: true });
      await qc.invalidateQueries({ queryKey: ME_KEY });
      toast.success("Checklist hidden");
      nav("/app/dashboard");
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setHiding(false);
    }
  };
  return (
    <Page className="max-w-3xl">
      <PageHeader
        title="Getting started"
        description="Everything between a new workspace and your first replies, in order."
        actions={
          <Button variant="ghost" loading={hiding} onClick={hide}>
            I'm done with this
          </Button>
        }
      />
      {setup.data && <Progress value={setup.data.completed} max={setup.data.total} className="mb-6" />}
      <ol className="space-y-3">
        {steps.map((c, i) => {
          const ok = done.get(c.key);
          return (
            <li key={c.key}>
              <Card className={cn("flex gap-4", ok && "opacity-70")}>
                <div className="pt-0.5">{ok ? <CheckCircle2 size={22} className="text-ok" /> : <Circle size={22} className="text-faint" />}</div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-faint">Step {i + 1}</p>
                  <h3 className="text-[15px] font-semibold">{c.title}</h3>
                  <p className="mt-1 text-[13px] text-muted">{c.body}</p>
                </div>
                {!ok && (
                  <div className="shrink-0 self-center">
                    {c.to ? (
                      <ButtonLink to={c.to} size="sm" variant="soft">
                        {c.cta}
                      </ButtonLink>
                    ) : (
                      <Button
                        size="sm"
                        variant="soft"
                        onClick={() => void resendConfirmation(!!me.features.owner)}
                      >
                        {c.cta}
                      </Button>
                    )}
                  </div>
                )}
              </Card>
            </li>
          );
        })}
      </ol>
      <p className="mt-8 text-center text-[13px] text-muted">
        Prefer the API?{" "}
        <Link to="/developers" className="inline-flex items-center gap-1 text-brand-text hover:underline" target="_blank">
          Read the docs <ExternalLink size={12} />
        </Link>
      </p>
    </Page>
  );
}
